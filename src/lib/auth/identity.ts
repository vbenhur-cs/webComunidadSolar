export interface Identity {
  displayName: string;
  email: string;
  fullName: string | null;
}

const userEmailHeader = "oai-authenticated-user-email";
const userFullNameHeader = "oai-authenticated-user-full-name";
const userFullNameEncodingHeader = "oai-authenticated-user-full-name-encoding";
const percentEncodedUtf8 = "percent-encoded-utf-8";

export function readIdentity(headers: Headers): Identity | null {
  const email = headers.get(userEmailHeader);
  if (!email) return null;

  const encodedFullName = headers.get(userFullNameHeader);
  const fullName =
    encodedFullName &&
    headers.get(userFullNameEncodingHeader) === percentEncodedUtf8
      ? safeDecodeURIComponent(encodedFullName)
      : null;

  return {
    displayName: fullName ?? email,
    email,
    fullName,
  };
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
