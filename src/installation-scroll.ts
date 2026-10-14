/** Keep editor navigation inside its body; scrollIntoView can also scroll the dialog. */
export function scrollInstallationContent(
  element: HTMLElement | null | undefined,
  block: 'start' | 'nearest' = 'nearest',
) {
  const scroll =
    element?.closest<HTMLElement>('.installation-content-scroll') ??
    element?.closest<HTMLElement>('.m-installation-form .m-form-scroll');
  if (!element || !scroll) return;
  const bounds = scroll.getBoundingClientRect();
  const target = element.getBoundingClientRect();
  const top = bounds.top + scroll.clientTop + 16;
  const bottom = bounds.top + scroll.clientTop + scroll.clientHeight - 16;
  let delta = 0;
  if (block === 'start' || target.top < top) delta = target.top - top;
  else if (target.bottom > bottom)
    delta = target.height > bottom - top ? target.top - top : target.bottom - bottom;
  if (delta)
    scroll.scrollTo({
      top: Math.max(0, Math.min(scroll.scrollHeight - scroll.clientHeight, scroll.scrollTop + delta)),
      behavior: 'instant',
    });
}

export function focusInstallationField(element: HTMLElement | null | undefined) {
  element?.focus({ preventScroll: true });
  scrollInstallationContent(element);
}
