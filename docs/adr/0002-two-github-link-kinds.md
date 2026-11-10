# 0002: Two ways to link GitHub, side by side

Date: 2026-11-10. Minion #464.

## Context

People link GitHub through Citadel's OAuth App with `repo workflow`: read and write on every repo they
can reach. Josh, 2026-11-10: "I added Alex to Citadel and he isnt working as closely with me as Josh and
isnt comfortable with the level of access required to link git, can we make the scope more limited to
only the relevant repos instead of full access?"

OAuth Apps have no per-repo scope. Fine-grained personal access tokens can't contribute to a repo where
the person is a collaborator on another personal account
([GitHub's list of gaps](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)),
and most schemes' repos are under one person's account. A GitHub App's user token reaches only repos
where the App is installed and the person has access
([GitHub's docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)).

## Decision

Both, side by side. The first plan replaced the OAuth App; Josh, 2026-11-10: "Lets do both? I dont want
to have to deal with this personally, but I want alex to be able to do what he is comfortable with?",
then "Plan approved: build it this way."

- The OAuth App's full-access link stays exactly as it was. Nobody relinks.
- A limited link goes through a GitHub App (`GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`,
  `GITHUB_APP_SLUG`). A person has one link; linking the other way replaces it and revokes the old one.
- The App's user tokens don't expire (the App's setting): GitHub's refresh invalidates the old access
  token at once, and a person often has several turns running on it.
- The kind is kept in the credential's meta (`app: true`), so no migration.

## Consequences

- Two sign-in flows to keep working.
- A limited link works on a repo only after the repo's owner installs the App there; refusals look like
  a missing repo, so the account page lists what the link reaches and errors name the install page.
- A scheme owner on a limited link needs the App on the scheme's repo for invites and runner tokens.
