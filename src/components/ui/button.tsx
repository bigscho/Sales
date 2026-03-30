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
            "bg-[var(--primary)] text-white hover:bg-green-700 focus:ring-green-500": variant === "default",
            "border border-[var(--border)] bg-white hover:bg-[var(--muted)] focus:ring-gray-300": variant === "outline",
            "hover:bg-[var(--muted)] focus:ring-gray-300": variant === "ghost",
            "bg-[var(--destructive)] text-white hover:bg-red-600 focus:ring-red-500": variant === "destructive",
            "bg-[var(--muted)] text-[var(--foreground)] hover:bg-gray-200 focus:ring-gray-300": variant === "secondary",
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
