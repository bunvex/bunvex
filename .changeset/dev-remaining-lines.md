---
"@bunvex/cli": patch
---

`bunvex dev` prints Convex's current lines. A first local run says "Setting up a new project..." and, on a terminal, what `dev` does and "Continue?". The configuration lines list what changed in `.env.local` (and `.gitignore`), followed by where to write functions, where to give feedback and the dashboard. The deployment is named as Convex's `announceDeploymentTarget` does, and durations use Convex's units. A self-hosted `dev` saves the deployment's URLs to `.env.local` (and removes `BUNVEX_DEPLOYMENT`), as Convex's.
