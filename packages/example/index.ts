import { buildGreeting } from "./lib/impl.ts";

export function greet(name: string): string {
  return buildGreeting(name.trim() || "world");
}
