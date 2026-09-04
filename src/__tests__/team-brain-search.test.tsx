import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { TeamBrainSearch } from '../components/team/TeamBrainSearch';

describe('TeamBrainSearch (stub)', () => {
  it('renders null — team brain search is now part of the Brain space', () => {
    const { container } = render(<TeamBrainSearch members={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
