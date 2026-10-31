/** "name@host:password" pasted into the address field → address + password. */
export function splitMailInput(value: string): { address: string; password: string } | null {
  const m = value.trim().match(/^([^\s:@]+@[^\s:]+):(.+)$/);
  return m ? { address: m[1], password: m[2] } : null;
}

/** Where OpenAI asks for a phone number — opened when sign-in stops on "verify your phone". */
export const OPENAI_PHONE_URL = "https://auth.openai.com/add-phone";
