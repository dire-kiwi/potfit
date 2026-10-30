# flowerpot

Published as `dire-kiwi/potfit` on GitHub (public). See README.md.

- Changes go through pull requests: push the branch to `origin` and open one against `master`
  (`gh pr create --repo dire-kiwi/potfit --base master`). At the merge stage, merge it on GitHub
  (`gh pr merge <number> --repo dire-kiwi/potfit --merge`) rather than into the local `master`,
  then bring the main checkout up to date with `git pull --ff-only origin master` if it's on
  `master` and clean.
- A push to `master` deploys potfit. The deployment lives in a separate private repository, so
  don't commit host names, addresses, users or other details of a particular deployment here.
- Blender scenes (`*.blend`) stay out of git: they're large, and the scripts write them.
