import { configureStore } from '@reduxjs/toolkit';
import { useDispatch, useSelector } from 'react-redux';
import { api } from '../features/auth/authApi';
import auth from '../features/auth/authSlice';
import toast, { toastListener } from '../features/toast/toast';

export function makeStore() {
  return configureStore({
    reducer: { auth, toast, [api.reducerPath]: api.reducer },
    middleware: (getDefault) => getDefault().prepend(toastListener.middleware).concat(api.middleware),
  });
}

export type AppStore = ReturnType<typeof makeStore>;
export type RootState = ReturnType<AppStore['getState']>;
export type AppDispatch = AppStore['dispatch'];

export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();
