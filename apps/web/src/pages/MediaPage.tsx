import { MediaBrowser } from "@/components/MediaBrowser";
import { PageHeader } from "@/components/PageHeader";

/** Every image and video the Faculty screens can show, in one place. Picking happens where they are used. */
export function MediaPage() {
  return (
    <div>
      <PageHeader title="Media library" description="Upload, rename, move, replace and delete the images and videos used on the Faculty screens." />
      <MediaBrowser mode="manage" />
    </div>
  );
}
