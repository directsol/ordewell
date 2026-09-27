import { createContext } from 'react';

/**
 * Whether the conversation shows every thinking, command and subagent block
 * in full. One switch for all of them, like the TUI's ctrl+o; a header
 * control flips it through `setDetailAll`.
 */
export interface Detail {
  detailAll: boolean;
  setDetailAll: (on: boolean) => void;
}

export const DetailContext = createContext<Detail>({ detailAll: false, setDetailAll: () => {} });
