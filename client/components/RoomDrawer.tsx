import { useEffect, useRef, type ReactNode } from 'react';

export function RoomDrawer({ title, close, children, wide = false }: { title: string; close: () => void; children: ReactNode; wide?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    if (typeof dialog.current?.showModal === 'function') dialog.current.showModal();
    else dialog.current?.setAttribute('open', '');
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} className={'room-drawer' + (wide ? ' wide' : '')} aria-label={title} onCancel={(event) => { event.preventDefault(); close(); }}>
    <div className="drawer-heading"><h2>{title}</h2><button className="quiet" onClick={close} aria-label="关闭详情">关闭 ×</button></div>
    <div className="drawer-content">{children}</div>
  </dialog>;
}
