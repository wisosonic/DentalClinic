import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PageHeader } from '../components/PageHeader';

const LONG = 'Muhammad Abdul Rahman Al-Hashemi Al-Qurashi Bin Abdullah Bin Mahmoud';

describe('page header', () => {
  it('puts the buttons beside the title by default', () => {
    render(<PageHeader title="Patients" actions={<button>Add</button>} />);
    const row = screen.getByRole('heading', { name: 'Patients' }).parentElement!.parentElement!;
    expect(getComputedStyle(row).flexDirection).toBe('row');
  });

  it('always puts the buttons on their own row under a long title when asked', () => {
    render(<PageHeader title={LONG} subtitle="Patient #1" actionsBelow actions={<><button>One</button><button>Two</button></>} />);
    const heading = screen.getByRole('heading', { name: LONG });
    const row = heading.parentElement!.parentElement!;
    expect(getComputedStyle(row).flexDirection).toBe('column');
    // the buttons come after the whole title block, so they can never share its row
    expect(heading.parentElement!.nextElementSibling ?? heading.parentElement!.nextSibling).toBeTruthy();
    expect(screen.getByRole('button', { name: 'One' })).toBeInTheDocument();
  });
});
