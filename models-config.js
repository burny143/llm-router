/**
 * Default model configuration for LLM Proxy Router
 * Each provider group contains: provider name, baseURL, apiKeyEnv, and list of models
 */
module.exports = [
  {
    provider: 'Anthropic',
    baseURL: 'https://api.anthropic.com/v1/messages',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    models: [
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
      'claude-3-sonnet-20240229',
      'claude-3-haiku-20240307'
    ]
  },
  {
    provider: 'OpenAI',
    baseURL: 'https://api.openai.com/v1/chat/completions',
    apiKeyEnv: 'OPENAI_API_KEY',
    models: [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4-turbo',
      'gpt-4',
      'gpt-3.5-turbo'
    ]
  },
  {
    provider: 'Google AI Studio',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/models',
    apiKeyEnv: 'GOOGLE_AI_STUDIO_API_KEY',
    models: [
      'gemini-1.5-pro',
      'gemini-1.5-flash',
      'gemini-1.0-pro'
    ]
  },
  {
    provider: 'Kilo Gateway',
    baseURL: 'https://api.kilocode.ai/v1/chat/completions',
    apiKeyEnv: 'KILO_GATEWAY_API_KEY',
    models: [
      'kilo-code-default'
    ]
  },
  {
    provider: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1/chat/completions',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    models: [
      'anthropic/claude-3.5-sonnet',
      'anthropic/claude-3.5-haiku',
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'google/gemini-pro-1.5',
      'meta-llama/llama-3.1-405b-instruct',
      'meta-llama/llama-3.1-70b-instruct'
    ]
  },
  {
    provider: 'NVIDIA NIM',
    baseURL: 'https://integrate.api.nvidia.com/v1/chat/completions',
    apiKeyEnv: 'NVIDIA_NIM_API_KEY',
    models: [
      'meta/llama-3.1-405b-instruct',
      'meta/llama-3.1-70b-instruct',
      'nvidia/nemotron-3-ultra'
    ]
  },
  {
    provider: 'Mistral',
    baseURL: 'https://api.mistral.ai/v1/chat/completions',
    apiKeyEnv: 'MISTRAL_API_KEY',
    models: [
      'mistral-large-latest',
      'mistral-small-latest',
      'codestral-latest',
      'open-mistral-7b'
    ]
  },
  {
    provider: 'Codestral',
    baseURL: 'https://codestral.mistral.ai/v1/chat/completions',
    apiKeyEnv: 'CODESTRAL_API_KEY',
    models: [
      'codestral-latest'
    ]
  },
  {
    provider: 'Hugging Face',
    baseURL: 'https://api-inference.huggingface.co/v1/chat/completions',
    apiKeyEnv: 'HUGGINGFACE_API_KEY',
    models: [
      'meta-llama/Meta-Llama-3-8B-Instruct',
      'meta-llama/Meta-Llama-3-70B-Instruct',
      'mistralai/Mistral-7B-Instruct-v0.3',
      'mistralai/Mixtral-8x7B-Instruct-v0.1',
      'google/gemma-2-9b-it',
      'microsoft/Phi-3-mini-4k-instruct'
    ]
  },
  {
    provider: 'Vercel AI Gateway',
    baseURL: 'https://ai-gateway.vercel.sh/v1/chat/completions',
    apiKeyEnv: 'VERCEL_AI_GATEWAY_API_KEY',
    models: [
      'gateway-default'
    ]
  },
  {
    provider: 'Zen',
    baseURL: 'https://api.z.ai/api/v1/chat/completions',
    apiKeyEnv: 'ZEN_API_KEY',
    models: [
      'zen-default'
    ]
  },
  {
    provider: 'Cerebras',
    baseURL: 'https://api.cerebras.ai/v1/chat/completions',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    models: [
      'llama3.1-8b',
      'llama3.1-70b'
    ]
  },
  {
    provider: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1/chat/completions',
    apiKeyEnv: 'GROQ_API_KEY',
    models: [
      'llama-3.1-405b-reasoning',
      'llama-3.1-70b-versatile',
      'llama-3.1-8b-instant',
      'mixtral-8x7b-32768'
    ]
  },
  {
    provider: 'Cohere',
    baseURL: 'https://api.cohere.ai/v1/chat',
    apiKeyEnv: 'COHERE_API_KEY',
    models: [
      'command-r-plus',
      'command-r',
      'command'
    ]
  },
  {
    provider: 'Fireworks',
    baseURL: 'https://api.fireworks.ai/inference/v1/chat/completions',
    apiKeyEnv: 'FIREWORKS_API_KEY',
    models: [
      'accounts/fireworks/models/llama-v3p1-405b-instruct',
      'accounts/fireworks/models/llama-v3p1-70b-instruct',
      'accounts/fireworks/models/mixtral-8x7b-instruct'
    ]
  },
  {
    provider: 'Command',
    baseURL: 'https://api.cohere.com/v1/chat',
    apiKeyEnv: 'COMMAND_API_KEY',
    models: [
      'command-r-plus',
      'command-r'
    ]
  },
  {
    provider: 'LM Studio (Local)',
    baseURL: 'http://localhost:1234/v1/chat/completions',
    apiKeyEnv: 'LMSTUDIO_LOCAL_API_KEY',
    models: [
      'local-model'
    ]
  }
];