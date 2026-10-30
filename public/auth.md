# auth.md

This service is public and authless. No agent registration, API key, token, or login is required.

## Audience

All agents and clients may use the public tile and style endpoints.

## Agent registration

This service has no registration flow. Access is anonymous.

```json
{
  "agent_auth": {
    "skill": "authless",
    "register_uri": "https://tiles.jasontally.com/auth.md",
    "identity_types_supported": ["anonymous"],
    "anonymous": {
      "credential_types_supported": ["none"],
      "claim_uri": "https://tiles.jasontally.com/auth.md"
    }
  }
}
```

## Registration

No registration or provisioning endpoint is required.

## Methods

- none

## Credential use

No credentials are used. Fetch resources with ordinary HTTP GET and Range requests.