import type { ComponentProps } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * Icon-only button with a visible tooltip.
 * `label` is what screen readers hear and should name the target ("Xoá kênh Shop A"), since rows repeat the same icon;
 * `tooltip` is the short visible text ("Xoá"), defaulting to `label`.
 */
export function IconAction({
  label,
  tooltip,
  variant = 'ghost',
  size = 'icon-sm',
  ...props
}: Omit<ComponentProps<typeof Button>, 'aria-label' | 'title'> & { label: string; tooltip?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant={variant} size={size} aria-label={label} {...props} />
      </TooltipTrigger>
      <TooltipContent>{tooltip ?? label}</TooltipContent>
    </Tooltip>
  );
}
