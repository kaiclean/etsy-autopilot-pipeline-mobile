import type { Metadata } from "next";
import { BrainNav } from "@/components/brain/nav";
import "./brain.css";

export const metadata: Metadata = { title: "Brain" };

export default function BrainLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="brain">
      <BrainNav />
      <div className="brain-main">{children}</div>
    </div>
  );
}
