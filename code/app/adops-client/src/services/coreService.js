import axios from 'axios';

// CoreService (/core): the role-less front door. This module is the single
// place that reads server-derived identity; gates consume its result, never
// a client-side guess.
const http = axios.create({ timeout: 120000 });

let userInfoPromise = null;

export async function fetchUserInfo({ fresh = false } = {}) {
  if (!userInfoPromise || fresh) {
    userInfoPromise = http
      .get('/core/userInfo()')
      .then((response) => response.data)
      .catch((error) => {
        userInfoPromise = null;
        throw error;
      });
  }
  return userInfoPromise;
}

export function getServiceErrorMessage(error, fallback) {
  const data = error?.response?.data;
  return (
    data?.error?.message ||
    (typeof data === 'string' && data) ||
    error?.message ||
    fallback ||
    'The request failed.'
  );
}
