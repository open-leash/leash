-- Bind custom-scheme OAuth callbacks to the exact Desktop/mobile process that
-- initiated sign-in. A hostile app can register the same URL scheme, but it
-- cannot redeem the returned code without the one-time verifier.
alter table oauth_login_states
  add column if not exists code_challenge text;

