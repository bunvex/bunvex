// The project's bundle and `start_push`'s request, as `bunvex deploy` builds them, for `@bunvex/testing` to push into
// a test's engine (STUDY-159): the app a test runs is the app a deployment runs.
export { type BundledProject, bundleProject, pushRequest } from "./deploy.ts";
