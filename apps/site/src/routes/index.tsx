import { createFileRoute } from "@tanstack/react-router";
import { Landing } from "../components/landing.tsx";

export const Route = createFileRoute("/")({ component: Landing });
