import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { CLINIC, json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const setup = (logoUrl: string | null) => {
  api.routes['GET /auth/me'] = () => json(200, { user: user('admin') });
  api.routes['GET /clinics'] = () => json(200, { data: [{ ...CLINIC, logoUrl }] });
  api.routes['GET /doctors'] = () => json(200, { data: [] });
  api.routes['GET /clinics/1/doctors'] = () => json(200, { data: [] });
  api.routes['GET /units'] = () => json(200, { data: [] });
};

describe('application logo', () => {
  it('is shown in the header', async () => {
    api.routes['GET /auth/me'] = () => json(200, { user: user('admin') });
    renderApp(<App />);
    await screen.findByRole('heading', { name: /Welcome/ });
    const logos = document.querySelectorAll('img[src="/images/logo.png"]');
    expect(logos.length).toBeGreaterThan(0);
  });
});

describe('clinic logo', () => {
  it('is shown next to the clinic name', async () => {
    setup('/api/v1/clinics/1/logo?v=abc123abc123');
    renderApp(<App />, '/settings/clinics');
    const img = await screen.findByRole('img', { name: 'Aya Ghali Clinic logo' });
    expect(img).toHaveAttribute('src', '/api/v1/clinics/1/logo?v=abc123abc123');
    expect(screen.getByRole('button', { name: 'Change logo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove logo' })).toBeInTheDocument();
  });

  it('offers an upload when there is none, and sends the chosen file', async () => {
    setup(null);
    api.routes['PUT /clinics/1/logo'] = () => json(200, { clinic: { ...CLINIC, logoUrl: '/api/v1/clinics/1/logo?v=aaaaaaaaaaaa' } });
    renderApp(<App />, '/settings/clinics');
    expect(await screen.findByRole('button', { name: 'Upload logo' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove logo' })).not.toBeInTheDocument();
    const file = new File([new Uint8Array(10)], 'logo.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Clinic logo file', { selector: 'input' }), { target: { files: [file] } });
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT' && c.path === '/clinics/1/logo')).toBe(true));
  });

  it('refuses other file types and big files without calling the server', async () => {
    setup(null);
    renderApp(<App />, '/settings/clinics');
    await screen.findByRole('button', { name: 'Upload logo' });
    const input = screen.getByLabelText('Clinic logo file', { selector: 'input' });
    fireEvent.change(input, { target: { files: [new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' })] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a PNG, JPEG or WebP image');
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(600 * 1024)], 'big.png', { type: 'image/png' })] } });
    expect(await screen.findByText('The logo must be smaller than 512 KB')).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});
