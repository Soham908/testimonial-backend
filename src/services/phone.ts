// Shared by POST /register and POST /login/phone - both need the exact same
// normalization so a phone typed differently at each step (spacing, dashes,
// a leading +91) still resolves to the same stored identifier. Strips
// everything but digits, then keeps the last 10 - Indian mobile numbers are
// 10 digits, so a country code (91/+91) just falls off the front rather than
// needing explicit handling.
export function normalizePhone(phone: string): string {
  const digitsOnly = phone.replace(/\D/g, "");
  return digitsOnly.slice(-10);
}
