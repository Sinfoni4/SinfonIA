/** The logo of an organization, as GET /organization/logo and the console return it. */
export type OrganizationLogo = { contentType: string; data: string; updatedAt: string };

/** The formats and the size the server accepts (src/core/organization/organization-logo.ts). */
export const LOGO_ACCEPT = 'image/svg+xml,image/png,image/jpeg,image/webp';
export const LOGO_MAX_BYTES = 200 * 1024;

/** An image source that never runs anything: an SVG from a data URL is only drawn. */
export function logoSrc(logo: OrganizationLogo): string {
  return `data:${logo.contentType};base64,${logo.data}`;
}

/** The chosen file in base64, without the `data:…;base64,` prefix. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result.replace(/^data:[^,]*,/, ''))
        : reject(new Error('File non leggibile'));
    reader.onerror = () => reject(reader.error ?? new Error('File non leggibile'));
    reader.readAsDataURL(file);
  });
}
