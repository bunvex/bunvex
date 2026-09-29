// Class-name helper used by every component: joins conditional classes and lets a later Tailwind utility
// override an earlier one of the same group (`cn("px-2", "px-4")` → "px-4").
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
