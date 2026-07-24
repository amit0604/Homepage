/**
 * Upload an image file to server volume; returns public URL string.
 */
export async function uploadAdminImage(file) {
  const token = localStorage.getItem('token');
  const formData = new FormData();
  formData.append('image', file);
  const response = await fetch('/api/uploads/image', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  });
  let body = {};
  try {
    body = await response.json();
  } catch (_) {
    /* ignore */
  }
  if (!response.ok) {
    throw new Error(body.message || `Upload failed (${response.status})`);
  }
  return body.url;
}
