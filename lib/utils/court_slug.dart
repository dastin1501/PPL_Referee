/// Lowercase hyphenated court slug for overlay rooms / match_update payloads.
///
/// Examples: `"Center Court"` → `center-court`, `"Court 1"` → `court-1`.
String courtSlug(String? courtName) {
  var s = (courtName ?? '').trim().toLowerCase();
  if (s.isEmpty) return '';
  s = s.replaceAll(RegExp(r'[^a-z0-9]+'), '-');
  s = s.replaceAll(RegExp(r'-+'), '-');
  s = s.replaceAll(RegExp(r'^-|-$'), '');
  return s;
}
