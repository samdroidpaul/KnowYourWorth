import { Backdrop } from "@/components/Backdrop";
import { Chat } from "@/components/Chat";

export default function Page() {
  return (
    <main className="relative min-h-screen w-full grid place-items-center p-4 md:p-6">
      <Backdrop />
      <Chat />
    </main>
  );
}
