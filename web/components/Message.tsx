"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { motion } from "framer-motion";
import type { ChatMessage } from "@/lib/types";
import { stripJsonFence } from "@/lib/parseResult";
import { SalaryTable } from "./SalaryTable";

type Props = { message: ChatMessage; bannerLoading?: boolean };

function MessageInner({ message, bannerLoading }: Props) {
  const isUser = message.role === "user";
  const visible = isUser ? message.text : stripJsonFence(message.text);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className={`flex w-full ${isUser ? "justify-end" : "justify-start"}`}
    >
      <div
        className={`max-w-[88%] md:max-w-[78%] ${
          isUser
            ? "bg-accent-600 text-white rounded-2xl rounded-br-md px-4 py-2.5 shadow-glow"
            : "text-ink-800 dark:text-ink-100"
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{visible}</p>
        ) : (
          <div className="prose-chat text-[0.95rem]">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {visible || "​"}
            </ReactMarkdown>
            {message.streaming && (
              <span className="caret" aria-hidden />
            )}
          </div>
        )}

        {!isUser && message.report && (
          <SalaryTable
            report={message.report}
            banner={message.banner}
            bannerLoading={bannerLoading && !message.banner}
          />
        )}
      </div>
    </motion.div>
  );
}

export const Message = memo(MessageInner);
