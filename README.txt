Jev Router for Codex
====================

Unofficial Codex plugin that asks TypeSafe AI's Jev model for an advisory,
typed routing hint before each prompt. AgentKit and Codex safety rules remain
authoritative. Missing keys, timeouts, network errors, HTTP errors, sensitive
prompts, and invalid responses fail open to the normal routing flow.

Install
-------

  codex plugin marketplace add sonson0910/jev-router
  codex plugin add jev-router@jev-router

Store the TypeSafe API key locally
----------------------------------

  install -d -m 700 "$HOME/.config/typesafe"
  read -rsp 'TypeSafe API key: ' jev_api_key; printf '\n'
  umask 077
  printf '%s' "$jev_api_key" > "$HOME/.config/typesafe/api-key"
  unset jev_api_key

The plugin also accepts TYPESAFE_API_KEY from the environment. The local key
file must be a regular non-symlink file with no group or other permissions.

Optional controls
-----------------

  JEV_ROUTER_ENABLED=0       Disable the router.
  JEV_ROUTER_DEBUG=1         Print skip/fallback reasons to stderr.
  JEV_ROUTER_TIMEOUT_MS=1200 Set timeout from 250 through 5000 ms.
  TYPESAFE_DEFAULT_MODEL     Override jev-latest.

After installation, start a new Codex thread and review/trust the hook in
/hooks. Never commit the API key.

Test
----

  node --test plugins/jev-router/hooks/jev-router.test.cjs

