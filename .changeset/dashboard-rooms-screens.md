---
---

The dashboard shows rooms and presence scopes (AD-43): a Rooms screen lists the open ones by definition, then args, with their members, connections and when they opened, filtered by definition and sorted by members; a room opens with its members a page at a time (presence or state, idle, can publish, reconnecting, connections, joined, last activity), and says when it closes. The Functions screen lists the deploy's `room()` and `presence()` definitions under the function tree, each with its args, presence or state validator and events. The Overview gets a Rooms section with the gauges and the counters' rates. All of it is read every second while shown, not while the tab is hidden; a deployment without rooms says so (`@bunvex/dashboard`, not published separately).
