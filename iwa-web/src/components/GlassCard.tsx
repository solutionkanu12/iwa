import type { HTMLAttributes } from "react";
import styles from "./GlassCard.module.css";

type GlassCardProps = HTMLAttributes<HTMLDivElement>;

/**
 * Glass card: translucent cloud with a backdrop blur, meant to sit over
 * imagery (nav, dock, FAQ card, community card). Frosted, never a dimming layer.
 */
export function GlassCard({ className, children, ...rest }: GlassCardProps) {
  const cls = className ? `${styles.glass} ${className}` : styles.glass;
  return (
    <div className={cls} {...rest}>
      {children}
    </div>
  );
}
