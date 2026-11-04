import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { AvaChart } from '../../client/components/AvaChart.js';
afterEach(cleanup);

it('isolates chart scripts and uses only the local pinned runtime, with escaped JSON data', () => {
  render(<AvaChart visualization={{ chartType: 'pie', config: { type: 'pie', title: '</script><script>bad()</script>', data: [{ category: '出牌', value: 3 }] } }} />);
  const frame = screen.getByTitle('AVA pie 图表') as HTMLIFrameElement;
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
  expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
  expect(frame.srcdoc).toContain('/chart-runtime/gpt-vis.js');
  expect(frame.srcdoc).toContain("connect-src 'none'");
  expect(frame.srcdoc).not.toContain('unpkg.com');
  expect(frame.srcdoc).not.toContain('</script><script>bad()');
  expect(frame.srcdoc).toContain('\\u003c/script>');
});
