import { render, screen } from '@testing-library/react';
import App from './App';

beforeEach(() => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => [],
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('renders support center shell', () => {
  render(<App />);
  expect(screen.getByRole('main')).toBeInTheDocument();
});
