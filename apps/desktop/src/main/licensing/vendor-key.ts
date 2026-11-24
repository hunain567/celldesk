/**
 * NexoERP's licence verification key (public part only).
 *
 * The matching private key exists only inside the NexoDesk License Manager on
 * the owner's laptop. Paste the key shown in License Manager > Settings here.
 * `pnpm dist:win` refuses to build an installer while this is null.
 */
export const VENDOR_PUBLIC_KEY_PEM: string | null = null;
