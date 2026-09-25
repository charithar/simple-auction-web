// https:// only: http:// is mixed content on the HTTPS site, and other schemes
// (data:, javascript:, blob:) have no business in an item photo. Relative paths
// point into public/; a leading / or // would escape base './' or go off-site.
export function imageUrlOk(u) {
  if (/^https:\/\/[^/\s]/i.test(u)) return true
  return !/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^[/\\]/.test(u) && !/\s/.test(u)
}
