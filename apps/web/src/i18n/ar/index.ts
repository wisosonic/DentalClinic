import { auth } from './auth';
import { messages } from './messages';
import { ui } from './ui';
import type { Dictionary } from './types';

/** Arabic for every interface string. Keys are the English text. */
const ar: Dictionary = { ...auth, ...ui, ...messages };
export default ar;
