/** Channel names for the sandboxed preload (kept free of zod). A test checks they match the contract. */
export const LM_CHANNEL_NAMES = [
  'vault:state',
  'vault:create',
  'vault:unlock',
  'vault:lock',
  'lm:dashboard',
  'lm:licenses',
  'lm:license',
  'lm:createLicense',
  'lm:extend',
  'lm:setStatus',
  'lm:openRequestFile',
  'lm:previewRequest',
  'lm:issueForRequest',
  'lm:issueForDevice',
  'lm:removeDevice',
  'lm:saveLicenseFile',
  'lm:settings',
  'lm:backup',
] as const;

export const LM_INVOKE = 'license-manager:invoke';
