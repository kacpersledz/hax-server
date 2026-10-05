# Brave autofill and HAX server HTTP Basic Auth

The HAX server uses HTTP Basic Authentication when `USERNAME` and `PASSWORD`
are configured. The challenge is emitted with the realm:

```http
WWW-Authenticate: Basic realm="Restricted Area"
```

## Symptom

A credential added manually in Brave's password manager can appear correct in
the UI but is not offered for the HAX server authentication prompt.

If Brave itself offers to save the credential after a successful login, the
saved credential does autofill correctly later.

## Root cause

Brave/Chromium stores these as different credential types.

A manually added credential was observed as:

```text
origin_url   = https://hax-server.kacpersledz.com/
signon_realm = https://hax-server.kacpersledz.com/
scheme       = 0
```

A working credential captured from the actual HTTP Basic Auth login was:

```text
origin_url   = https://hax-server.kacpersledz.com/
signon_realm = https://hax-server.kacpersledz.com/Restricted Area
scheme       = 1
```

The important difference is that `scheme = 1` represents HTTP Basic Auth and
the authentication realm becomes part of `signon_realm`.

Brave's password-manager UI does not expose this distinction, so the two entries
can look effectively identical.

## Preferred workaround

1. Delete the manually added HAX server entry from Brave.
2. Temporarily allow Brave's built-in password manager to save credentials.
3. Log in to the HAX server.
4. Accept Brave's save-password prompt.
5. Restore the normal password-manager setup.

This lets Brave capture the HTTP Basic Auth scheme and realm correctly.

## Inspecting Brave's stored entry

Fully close Brave before inspecting its databases.

### Find the profile

Do not assume the credential is under `Default` or `Profile 1`.

```bash
BRAVE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/BraveSoftware/Brave-Browser"

jq -r '
  .profile.info_cache
  | to_entries[]
  | [.key, .value.name]
  | @tsv
' "$BRAVE_DIR/Local State"
```

Example:

```text
Default     Personal
Profile 1   Work
```

Then search each profile for the HAX server entry:

```bash
SITE='https://hax-server.kacpersledz.com/'

while IFS=$'\t' read -r dir name; do
  db="$BRAVE_DIR/$dir/Login Data"
  [[ -f "$db" ]] || continue

  count=$(
    sqlite3 "$db" "
      SELECT count(*)
      FROM logins
      WHERE origin_url = '$SITE'
         OR signon_realm LIKE '$SITE%';
    "
  )

  if [[ "$count" -gt 0 ]]; then
    printf '%s\t%s\t%s entries\n' "$dir" "$name" "$count"
  fi
done < <(
  jq -r '
    .profile.info_cache
    | to_entries[]
    | [.key, .value.name]
    | @tsv
  ' "$BRAVE_DIR/Local State"
)
```

On NixOS, SQLite can be used without installing it globally:

```bash
nix shell nixpkgs#sqlite -c sqlite3 ...
```

Set `DB` to the matching profile's `Login Data` file and inspect only
non-secret metadata:

```bash
sqlite3 -header -column "$DB" "
  SELECT
    id,
    origin_url,
    signon_realm,
    scheme,
    password_type
  FROM logins
  WHERE origin_url = '$SITE'
     OR signon_realm LIKE '$SITE%';
"
```

Do not print `password_value` and do not share the `Login Data` database.

## Advanced note

A manually created entry can be converted into the working representation by
changing only its metadata:

- `scheme`: `0` -> `1`
- `signon_realm`: site URL -> site URL plus `Restricted Area`

The stored password itself does not need to be changed. If doing this directly,
only modify an unambiguous entry while Brave is fully closed.

If the server's Basic Auth realm changes in `server.mjs`, the corresponding
stored Brave realm must change too.
