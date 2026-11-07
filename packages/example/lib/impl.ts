export function buildGreeting(name: string): string {
  const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
  return `Hello, ${capitalized}!`;
}
