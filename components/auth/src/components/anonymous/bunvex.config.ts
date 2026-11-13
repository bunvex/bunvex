// The anonymous method's component (STUDY-201 §1.8): named `authAnonymous`, as v2's. One row per anonymous user,
// its app user id.
// Not exported since Convex Auth 2.0.0 hid the anonymous method until account linking (`bff2ce56`, STUDY-208 D-3): the
// source stays, as v2's does, for its tests.
import { defineComponent } from "@bunvex/server";

/**
 * The anonymous sign-in method's component.
 *
 * @internal Not public until the anonymous sign-in method is ready.
 */
const component = defineComponent("authAnonymous");

export default component;
