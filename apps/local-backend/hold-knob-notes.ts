// Imported first by ./local-backend.ts, so it runs before any module reads a knob: `localBackendMain` releases the
// lines once it has parsed the arguments (logged for the server, dropped for a subcommand).
import { holdKnobNotes } from "@bunvex/core/knobs";

holdKnobNotes();
