import type { MouseEvent, ReactNode } from 'react';

/** An anchor for hash routes. Same-hash clicks still re-fire so in-page selections and scrolling re-run. */
export function Link({ to, children, className, onClick }: { to: string; children: ReactNode; className?: string; onClick?: () => void }) {
  const click = (e: MouseEvent) => {
    onClick?.();
    if (window.location.hash === to) { e.preventDefault(); window.dispatchEvent(new HashChangeEvent('hashchange')); }
  };
  return <a href={to} className={className} onClick={click}>{children}</a>;
}

/** A reference to a repository path: a link when it is an approved document the viewer can open, plain text otherwise. */
export function RefLink({ path, label, href }: { path: string; label?: string; href: string | null }) {
  return href ? <Link to={href}>{label ?? path}</Link> : <span className="mono small">{label ?? path}</span>;
}
