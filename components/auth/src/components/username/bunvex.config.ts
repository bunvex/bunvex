// The username component (STUDY-201 §1.7): named `authUsername`, as v2's. It maps one username per user to the app's
// user id and keeps usernames unique; it is no sign-in method and knows no credentials. No configuration.
import { defineComponent } from "@bunvex/server";

const component = defineComponent("authUsername");

export default component;
