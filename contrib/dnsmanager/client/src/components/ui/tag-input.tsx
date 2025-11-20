import { useState, KeyboardEvent } from "react";
import { Input } from "./input";

interface TagInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  maxLength?: number;
}

export function TagInput({ value, onChange, placeholder, className, maxLength }: TagInputProps) {
  const [inputValue, setInputValue] = useState("");

  const tags = value ? value.split(",").map(t => t.trim()).filter(t => t) : [];

  const addTag = () => {
    const newTag = inputValue.trim();
    if (!newTag) return;

    if (tags.includes(newTag)) {
      setInputValue("");
      return;
    }

    const newTags = [...tags, newTag];
    onChange(newTags.join(","));
    setInputValue("");
  };

  const removeTag = (tagToRemove: string) => {
    const newTags = tags.filter(t => t !== tagToRemove);
    onChange(newTags.join(","));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addTag();
    } else if (e.key === "Backspace" && !inputValue && tags.length > 0) {
      // Remove last tag on backspace if input is empty
      removeTag(tags[tags.length - 1]);
    } else if (e.key === ",") {
      e.preventDefault();
      addTag();
    }
  };

  const handleBlur = () => {
    if (inputValue.trim()) {
      addTag();
    }
  };

  return (
    <div className={`flex min-h-[42px] w-full flex-wrap gap-1.5 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 ${className || ""}`}>
      {tags.map((tag, index) => (
        <span
          key={index}
          className="inline-flex items-center gap-1 rounded bg-blue-100 px-2 py-0.5 text-sm text-blue-700"
        >
          {tag}
          <button
            type="button"
            onClick={() => removeTag(tag)}
            className="ml-0.5 text-blue-500 hover:text-blue-700"
            aria-label={`Remove ${tag}`}
          >
            ×
          </button>
        </span>
      ))}
      <Input
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        placeholder={tags.length === 0 ? placeholder : ""}
        maxLength={maxLength}
        className="min-w-[120px] flex-1 border-0 p-0 focus-visible:ring-0 focus-visible:ring-offset-0"
      />
    </div>
  );
}
