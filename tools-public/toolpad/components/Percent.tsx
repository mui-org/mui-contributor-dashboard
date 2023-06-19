import * as React from "react";
import { createComponent } from "@mui/toolpad/browser";

const percentFormat = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 2,
  signDisplay: "always",
});

export interface ParsedProps {
  value: number;
}

function formatPercent(change: number | undefined): string {
  if (!change) {
    return "";
  }
  return percentFormat.format(change);
}

function Percent({ value }: ParsedProps) {
  return <>{formatPercent(value)}</>;
}

export default createComponent(Percent, {
  argTypes: {
    value: {
      type: "string",
    },
  },
});
