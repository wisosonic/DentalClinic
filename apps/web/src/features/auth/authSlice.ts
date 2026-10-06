import { createSlice } from '@reduxjs/toolkit';

interface AuthState {
  /** Set when a token refresh failed: the session is gone and the user must sign in again. */
  expired: boolean;
}

const slice = createSlice({
  name: 'auth',
  initialState: { expired: false } as AuthState,
  reducers: {
    sessionExpired(state) {
      state.expired = true;
    },
    sessionStarted(state) {
      state.expired = false;
    },
  },
});

export const { sessionExpired, sessionStarted } = slice.actions;
export default slice.reducer;
