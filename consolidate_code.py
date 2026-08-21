#!/usr/bin/env python3
"""consolidate_code.py

Recursively scan a project directory and combine all source code files into a
single Markdown document so the whole project can be reviewed or fed to an LLM
in one file.

Usage:
    python consolidate_code.py [root_dir] [-o OUTPUT] [-e EXT1,EXT2] [--max-size SIZE]

Examples:
    python consolidate_code.py                     # scan current directory
    python consolidate_code.py ../my-project       # scan another directory
    python consolidate_code.py -o docs/code.md     # custom output path
    python consolidate_code.py -e .py,.js,.ts      # only custom extensions
    python consolidate_code.py --max-size 1MB      # smaller size limit

Unless overridden with -e, the built-in default extension list is used.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Directories that are always skipped at any depth.
SKIP_DIRS = frozenset({
    ".git", ".svn", ".hg",
    "node_modules", "__pycache__",
    ".venv", "venv", "env",
    "dist", "build", "target", "bin", "obj",
    ".idea", ".vscode",
    "coverage", ".next", ".nuxt",
    "vendor", "bower_components", "Pods", "Carthage", "DerivedData",
    ".gradle", ".mvn", ".npm", ".yarn", ".pnp",
})

# File extension -> language name used for the Markdown code fence.
DEFAULT_LANG_MAP = {
    # Python
    ".py": "python", ".pyi": "python", ".pyw": "python",
    # JavaScript / TypeScript
    ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript", ".mts": "typescript", ".cts": "typescript",
    ".tsx": "typescript",
    # Java & friends
    ".java": "java",
    ".kt": "kotlin", ".kts": "kotlin",
    ".groovy": "groovy",
    ".scala": "scala", ".sc": "scala",
    # C family
    ".c": "c", ".h": "c",
    ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hh": "cpp", ".hpp": "cpp",
    ".cs": "csharp",
    ".m": "objectivec", ".mm": "objectivec",
    ".swift": "swift",
    # Web
    ".html": "html", ".htm": "html",
    ".css": "css", ".scss": "scss", ".sass": "scss", ".less": "less",
    ".styl": "stylus",
    ".vue": "vue",
    ".svelte": "svelte",
    ".astro": "astro",
    # Config / data languages
    ".json": "json", ".jsonc": "json",
    ".yaml": "yaml", ".yml": "yaml",
    ".toml": "toml",
    ".xml": "xml", ".xsd": "xml", ".xsl": "xml", ".xslt": "xml", ".svg": "xml",
    ".ini": "ini", ".cfg": "ini", ".conf": "ini",
    ".properties": "properties",
    ".sql": "sql",
    ".graphql": "graphql", ".gql": "graphql",
    ".proto": "protobuf",
    ".tf": "hcl", ".tfvars": "hcl",
    # Scripting
    ".sh": "bash", ".bash": "bash", ".zsh": "bash", ".ksh": "bash",
    ".ps1": "powershell", ".psm1": "powershell",
    ".bat": "bat", ".cmd": "bat",
    ".rb": "ruby", ".rake": "ruby",
    ".php": "php",
    ".pl": "perl", ".pm": "perl",
    ".lua": "lua",
    ".r": "r",
    # Other languages
    ".go": "go",
    ".rs": "rust",
    ".dart": "dart",
    ".ex": "elixir", ".exs": "elixir",
    ".erl": "erlang", ".hrl": "erlang",
    ".hs": "haskell",
    ".clj": "clojure", ".cljs": "clojure",
    ".ml": "ocaml",
    ".fs": "fsharp",
    ".vb": "vbnet",
    # Docs / text
    ".md": "markdown", ".markdown": "markdown",
    ".rst": "rst",
    ".adoc": "asciidoc",
    ".tex": "latex",
    ".txt": "text",
    ".dockerfile": "dockerfile",
}

# Well-known files without a normal file extension. Included only when the
# default (no -e) extension list is used. Keys are lower-cased names.
SPECIAL_FILES = {
    "dockerfile": "dockerfile",
    "makefile": "makefile",
    "gnumakefile": "makefile",
    "cmakelists.txt": "cmake",
    "jenkinsfile": "groovy",
    "gemfile": "ruby",
    "rakefile": "ruby",
    "procfile": "text",
    ".gitignore": "gitignore",
    ".gitattributes": "gitignore",
    ".editorconfig": "ini",
}

DEFAULT_OUTPUT = "project_code.md"
DEFAULT_MAX_SIZE = "2MB"
MAX_HEAD_BYTES = 1024  # number of bytes read to detect binary files

_SIZE_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?\s*$", re.IGNORECASE)
_SIZE_UNITS = {"": 1, "k": 1024, "m": 1024**2, "g": 1024**3, "t": 1024**4}


def parse_size(text: str) -> int:
    """Parse a size such as '2MB', '512k' or '1048576' into bytes."""
    match = _SIZE_RE.match(text)
    if not match:
        raise argparse.ArgumentTypeError(
            f"invalid size: {text!r} (use bytes or a suffix like K, M, G)"
        )
    return int(float(match.group(1)) * _SIZE_UNITS[match.group(2).lower()])


def normalize_extension(ext: str) -> str:
    """Normalize a user-supplied extension to '.lowercase' form."""
    ext = ext.strip().lower()
    if not ext:
        raise ValueError("empty extension")
    if not ext.startswith("."):
        ext = "." + ext
    return ext


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def is_binary(path: Path) -> bool:
    """Return True if the file looks binary (NUL byte in the first 1 KiB)."""
    try:
        with open(path, "rb") as handle:
            head = handle.read(MAX_HEAD_BYTES)
    except OSError:
        return True  # cannot read it; treat as binary so it gets skipped
    return b"\x00" in head


def read_text_file(path: Path) -> str:
    """Read a file as UTF-8, falling back to Latin-1 if UTF-8 fails."""
    raw = path.read_bytes()
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("latin-1")


def should_include(path: Path, extensions: set[str], special_files: dict) -> bool:
    """Return True if the path matches the configured extension / name list."""
    if special_files and path.name.lower() in special_files:
        return True
    return path.suffix.lower() in extensions


def language_for(path: Path, special_files: dict) -> str | None:
    """Pick the Markdown fence language for a path, or None if unknown."""
    if special_files:
        lang = special_files.get(path.name.lower())
        if lang:
            return lang
    return DEFAULT_LANG_MAP.get(path.suffix.lower())


def relative_posix(path: Path, root: Path) -> str:
    """Return the path relative to root, using forward slashes."""
    return os.path.relpath(path, root).replace(os.sep, "/")


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------

def collect_files(root: Path, output: Path, extensions: set[str],
                  special_files: dict, max_bytes: int):
    """Walk the tree and return (files_to_include, stats)."""
    files: list[Path] = []
    stats = {
        "scanned": 0,
        "skipped_binary": 0,
        "skipped_large": 0,
        "skipped_other": 0,
        "errors": 0,
    }

    norm_output = os.path.normcase(os.path.abspath(str(output)))

    for dirpath, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
        # Prune directories we never want to descend into.
        dirnames[:] = [name for name in dirnames if name not in SKIP_DIRS]

        for name in filenames:
            path = Path(os.path.join(dirpath, name))
            stats["scanned"] += 1

            # Never include the output file itself.
            if os.path.normcase(os.path.abspath(str(path))) == norm_output:
                continue

            if not should_include(path, extensions, special_files):
                stats["skipped_other"] += 1
                continue

            try:
                size = path.stat().st_size
            except OSError:
                stats["errors"] += 1
                continue

            if size > max_bytes:
                stats["skipped_large"] += 1
                continue

            if is_binary(path):
                stats["skipped_binary"] += 1
                continue

            files.append(path)

    # Consistent, reproducible order.
    files.sort(key=lambda p: relative_posix(p, root))
    return files, stats


def write_markdown(files: list[Path], root: Path, output: Path,
                   special_files: dict) -> None:
    """Write the combined Markdown document to `output`."""
    output.parent.mkdir(parents=True, exist_ok=True)

    now = datetime.now().astimezone().strftime("%Y-%m-%d %H:%M %Z")
    header = [
        "# Project Code Consolidation",
        "",
        f"- **Source directory:** `{root}`",
        f"- **Files included:** {len(files)}",
        f"- **Generated:** {now}",
        "",
    ]
    if not files:
        header.append("_No source files matched the scan criteria._")
        header.append("")

    with open(output, "w", encoding="utf-8", newline="\n") as handle:
        handle.write("\n".join(header))

        for path in files:
            rel = relative_posix(path, root)
            lang = language_for(path, special_files)

            try:
                content = read_text_file(path)
            except OSError as exc:
                print(f"  ! skipped unreadable file {rel}: {exc}", file=sys.stderr)
                continue

            if content and not content.endswith("\n"):
                content += "\n"

            fence = lang if lang else ""
            handle.write("\n---\n\n")
            handle.write(f"## File: {rel}\n\n")
            handle.write(f"```{fence}\n")
            handle.write(content)
            handle.write("```\n")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="consolidate_code.py",
        description="Combine a project's source files into a single Markdown document.",
        epilog=(
            "Examples:\n"
            "  python consolidate_code.py\n"
            "  python consolidate_code.py ../my-project -o docs/code.md\n"
            "  python consolidate_code.py -e .py,.js,.ts\n"
            "  python consolidate_code.py --max-size 1MB"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "root", nargs="?", default=".",
        help="root directory to scan (default: current directory)",
    )
    parser.add_argument(
        "-o", "--output", default=DEFAULT_OUTPUT,
        help=f"output Markdown file path (default: {DEFAULT_OUTPUT})",
    )
    parser.add_argument(
        "-e", "--extensions", metavar="EXT1,EXT2",
        help="comma-separated file extensions to include, e.g. '.py,.js'. "
             "Overrides the built-in default list.",
    )
    parser.add_argument(
        "--max-size", type=parse_size, default=parse_size(DEFAULT_MAX_SIZE),
        metavar="SIZE",
        help="skip files larger than this; bytes or with a K/M/G suffix "
             f"(default: {DEFAULT_MAX_SIZE})",
    )
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)

    root = Path(args.root).resolve()
    output = Path(args.output).resolve()
    max_bytes = args.max_size

    if not root.is_dir():
        print(f"Error: root directory does not exist: {root}", file=sys.stderr)
        return 1

    if args.extensions:
        try:
            extensions = {normalize_extension(e)
                          for e in args.extensions.split(",") if e.strip()}
        except ValueError as exc:
            print(f"Error: invalid extension in -e/--extensions: {exc}",
                  file=sys.stderr)
            return 1
        if not extensions:
            print("Error: -e/--extensions produced no valid extensions.",
                  file=sys.stderr)
            return 1
        special_files: dict[str, str] = {}
    else:
        extensions = set(DEFAULT_LANG_MAP)
        special_files = dict(SPECIAL_FILES)

    print(f"Scanning: {root}")
    files, stats = collect_files(root, output, extensions, special_files, max_bytes)

    write_markdown(files, root, output, special_files)

    print()
    print(f"Included files : {len(files)}")
    print(f"Skipped binary : {stats['skipped_binary']}")
    print(f"Skipped large  : {stats['skipped_large']}")
    print(f"Skipped other  : {stats['skipped_other']}")
    if stats["errors"]:
        print(f"Errors         : {stats['errors']}")
    print(f"Output         : {output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())