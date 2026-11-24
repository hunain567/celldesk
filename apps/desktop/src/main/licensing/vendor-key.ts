/**
 * NexoERP's licence verification key (public part only).
 *
 * The matching private key exists only inside the NexoDesk License Manager on
 * the owner's laptop. To change it, paste the key shown in License Manager >
 * Settings here. `pnpm dist:win` refuses to build an installer without a key.
 */
export const VENDOR_PUBLIC_KEY_PEM: string | null = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAoUYOCX5hv6LYFtTHB3HPPfI1/MesdknH6IFe2uMH/+4=
-----END PUBLIC KEY-----
`;
