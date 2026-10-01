import { hashPassword } from "better-auth/crypto";

const t: number[] = [];
for (let i = 0; i < 10; i++) {
  const t0 = performance.now();
  await hashPassword("password-123");
  t.push(performance.now() - t0);
}
t.sort((a, b) => a - b);
console.log(`scrypt hashPassword ×10: p50 ${t[5].toFixed(1)} ms`);
const t0 = performance.now();
await Promise.all(Array.from({ length: 20 }, () => hashPassword("password-123")));
console.log(`20 in parallel: ${(performance.now() - t0).toFixed(0)} ms`);
