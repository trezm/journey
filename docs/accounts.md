# Personal accounts

Journey supports personal accounts with a unique username, email and password. There are no organizations or memberships. Registration requires all three fields; sign-in accepts a username or email. Usernames and emails are trimmed and lowercased. Usernames contain 3–32 letters, numbers, underscores or hyphens and start with a letter or number. Passwords contain 12–256 characters and are never trimmed.

`POST /api/auth` accepts `{action:"register", username, email, password}`, `{action:"login", identifier, password}` or `{action:"logout"}`. Existing email-only login clients may keep sending `email` in place of `identifier`; registration clients must add `username`. Success returns `user:{id,name,username,email,agent:false}`. `GET /api/auth` returns the current user and deployment `mode`. Email is private account data and must not be exposed in public repository metadata.

Registration collisions return HTTP 409 with `username_exists` or `email_exists`. Invalid inputs return HTTP 400; incorrect login credentials return HTTP 401 without distinguishing a missing account. Authentication is rate limited by IP, account and IP/account pair for 15 minutes. Username/email login aliases share a bucket. D1 unique indexes arbitrate concurrent registration. Password hashes retain the existing PBKDF2 format for compatibility; comparison uses the runtime constant-time primitive.

Sessions last seven days. Login creates a fresh random session and invalidates the prior browser session, and logout revokes the current session. Session cookies are HttpOnly, Secure on HTTPS and SameSite=Lax so a top-level OAuth callback can return to the current session. Mutation endpoints check Origin; OAuth additionally uses single-use state and session binding. Duplicate session cookies do not authenticate.

## Migration and deployment

Apply `drizzle/0003_accounts.sql` before running this version. The migration preserves user IDs, password hashes, sessions and repository owners. Existing accounts receive deterministic unique usernames `user-1`, `user-2`, etc., ordered by their unchanged user IDs. They can continue to sign in by email and see their username in the account response. New registrations cannot reuse any existing username or email, including letter-case variants.

Set the non-secret Worker variable `AVC_AUTH_MODE=password` to select application accounts explicitly, even if legacy Access variables remain. Set `AVC_AUTH_MODE=access` to retain Cloudflare Access authentication. When omitted, any existing Access configuration keeps Access mode; otherwise the default is password mode. Invalid explicit values fail closed to Access. The existing checked-in deployment retains its Access setup until an operator deliberately changes it.

Cloudflare Access can also gate requests before the Worker runs. Changing `AVC_AUTH_MODE` alone does not make a protected host public. For a public multi-user deployment, deliberately update the Access application and bypass policy so the website, authentication routes, OAuth callback routes and intended public repository routes reach the Worker. Review that policy alongside [the Cloudflare deployment instructions](cloudflare.md). This feature does not deploy that policy change.

Access principals keep their existing verified mapped owner IDs; they are not automatically attached to password accounts with matching email addresses. Switching a deployment to password mode does not transfer Access-owned repositories. Any transfer requires a separate operator-reviewed owner migration after verifying the intended account; never infer ownership from an unverified registration email. Provider OAuth links grant repository sync access, not Journey account login or account ownership.

Email verification, password reset and account recovery are not part of this initial account release.
