"use client";

import { cn } from "@/lib/utils";
import { forwardRef, ButtonHTMLAttributes } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "outline" | "ghost" | "destructive" | "secondary";
  size?: "sm" | "md" | "lg";
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "md", ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center rounded-lg font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none",
          {
            "bg-[var(--primary)] text-[var(--primary-foreground)] hover:brightness-110 focus:ring-[var(--teal)]": variant === "default",
            "border border-[var(--border)] bg-[var(--card)] hover:bg-[var(--teal-tint)] focus:ring-[var(--teal)]": variant === "outline",
            "hover:bg-[var(--teal-tint)] focus:ring-[var(--teal)]": variant === "ghost",
            "bg-[var(--destructive)] text-[var(--destructive-foreground)] hover:brightness-110 focus:ring-[var(--destructive)]": variant === "destructive",
            "bg-[var(--muted)] text-[var(--foreground)] hover:brightness-95 focus:ring-[var(--teal)]": variant === "secondary",
          },
          {
            "h-8 px-3 text-sm": size === "sm",
            "h-10 px-4 text-sm": size === "md",
            "h-12 px-6 text-base": size === "lg",
          },
          className
        )}
        {...props}
      />
    );
  }
);

Button.displayName = "Button";
export { Button };
