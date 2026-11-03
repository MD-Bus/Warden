export const EXPIRY_MODES = ["shared", "separate"] as const
export type ExpiryMode = (typeof EXPIRY_MODES)[number]
export const MAX_LICENSE_APPS = 50
/** HTML input patterns use Unicode sets mode, where a literal hyphen must be escaped. */
export const TAG_PATTERN = /^[a-z][a-z0-9_\-]{0,47}$/
export const validTag = (value: unknown): value is string => typeof value === "string" && TAG_PATTERN.test(value)
export const isExpiryMode = (value: unknown): value is ExpiryMode => value === "shared" || value === "separate"
export type TemplateSlot = { tag: string; app: string | null; required: boolean }
export type LicenseTemplate = { id: string; name: string; description: string; expiry_mode: ExpiryMode; slots: TemplateSlot[]; created_at: number; updated_at: number }

export type AttachmentFacts = {
  tag: string
  app_id: string
  app_name: string
  app_slug: string
  status: string
  effective_status: string
  valid: boolean
  expires_at: number | null
  grace_ends_at: number | null
  last_check_at: number | null
  created_at: number
  expiring: boolean
  silent: boolean
}
